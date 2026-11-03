const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The only redirect URIs this connector hands codes to: claude.ai's callback, exactly, and plain
 * `http` on `localhost` or `127.0.0.1` with any port and path. Enforced at registration (DCR) and at
 * `/authorize`, which also covers Client ID Metadata Document clients.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri === CLAUDE_CALLBACK) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    !uri.includes("#")
  );
}
