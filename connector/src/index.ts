import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { GitHubFetch } from "./auth/github";
import { isAllowedRedirectUri } from "./auth/redirect-uris";
import { verifyServiceToken } from "./auth/service-tokens";
import { type DefaultEnv, authRoute } from "./auth/routes";
import { ConfigError, checkConfig, connectorHostname } from "./config";
import { GraphStore } from "./graphs";
import { purgeAuditLog } from "./audit/log";
import { mcpApiHandler } from "./mcp";
import { refreshAllKbIndexes } from "./tools/kb-index";
import { semanticBindings } from "./semantic/config";
import { runIndexer } from "./semantic/indexer";
import { SemanticStore } from "./semantic/store";
import { KB_INDEX_CRON, SEMANTIC_CRON } from "./crons";
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
  const resource = `https://${host}/mcp`;
  return {
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: defaultHandler(githubFetch) as ExportedHandler<Env>,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource, resource_name: "Logseq graphs" },
    // A bearer that is not an issued OAuth token: a service token, or the generic 401 (design §3.2).
    async resolveExternalToken({ token, env }) {
      const props = await verifyServiceToken(env, token, Date.now());
      return props ? { audience: resource, props } : null;
    },
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
        semanticBindings(env);
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
    /** Dispatches on the cron that fired; src/crons.ts lists them. */
    async scheduled(controller, env) {
      checkConfig(env);
      switch (controller.cron) {
        case KB_INDEX_CRON: {
          // The KB index refresh and the audit log purge run independently: either one's failure is
          // logged and surfaces after both ran, the KB index's first.
          // refreshAllKbIndexes logs each graph's outcome itself.
          let kbFailure: { error: unknown } | undefined;
          try {
            await refreshAllKbIndexes(env);
          } catch (error) {
            kbFailure = { error };
          }
          let purgeFailure: { error: unknown } | undefined;
          const started = Date.now();
          try {
            const { deleted, rowsRead, rowsWritten } = await purgeAuditLog(env, controller.scheduledTime);
            if (deleted > 0) {
              console.log(`audit-purge deleted=${deleted} rows_read=${rowsRead} rows_written=${rowsWritten} ms=${Date.now() - started}`);
            }
          } catch (error) {
            purgeFailure = { error };
            console.error(`audit-purge failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (kbFailure) throw kbFailure.error;
          if (purgeFailure) throw purgeFailure.error;
          return;
        }
        case SEMANTIC_CRON: {
          // This cron is rendered only with semantic search on, so a run without its bindings is a deploy error.
          const bindings = semanticBindings(env);
          if (!bindings) throw new Error("cron fired but semantic search is not configured (AI, VECTORIZE, SEMANTIC_MAX_VECTORS)");
          await runIndexer({ env, graphs: new GraphStore(env.DB, env.GRAPH_TOKEN_KEY), store: new SemanticStore(env.DB), bindings });
          return;
        }
        default:
          throw new Error(`unexpected cron "${controller.cron}"`);
      }
    },
  };
}

export default createConnector({ githubFetch: (url, init) => fetch(url, init) });
