import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { GitHubFetch } from "./auth/github";
import { isAllowedRedirectUri } from "./auth/redirect-uris";
import { type DefaultEnv, authRoute } from "./auth/routes";
import { ConfigError, checkConfig, connectorHostname } from "./config";
import { mcpApiHandler } from "./mcp";
import { refreshAllKbIndexes } from "./tools/kb-index";
import { wizardRoute } from "./wizard/routes";

function defaultHandler(githubFetch: GitHubFetch): ExportedHandler<DefaultEnv> {
  return {
    async fetch(request, env) {
      const route = authRoute(request, env, githubFetch) ?? wizardRoute(request, env);
      if (route) return route;
      return new Response("Not found", { status: 404 });
    },
  };
}

/**
 * The provider options for the connector's hostname. `resource` must be the exact
 * `https://<host>/mcp` URL the client reaches, and the provider takes it as a fixed string.
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
  // Built from CONNECTOR_HOSTNAME on first use. The env is fixed per deploy, so this is one provider.
  let pinned: { host: string; provider: OAuthProvider<Env> } | undefined;
  return {
    async fetch(request, env, ctx) {
      try {
        checkConfig(env);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        console.error(`connector misconfigured: ${error.message}`);
        return new Response("Server misconfigured", { status: 500 });
      }
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true });
      const host = connectorHostname(env);
      if (url.host !== host) return new Response("Misdirected request", { status: 421 });
      if (pinned?.host !== host) pinned = { host, provider: new OAuthProvider(providerOptions(host, githubFetch)) };
      return pinned.provider.fetch(request, env, ctx);
    },
    /** The hourly cron in wrangler.template.jsonc: rebuilds every graph's kb_index cache. */
    async scheduled(_controller, env) {
      checkConfig(env);
      await refreshAllKbIndexes(env);
    },
  };
}

export default createConnector({ githubFetch: (url, init) => fetch(url, init) });
