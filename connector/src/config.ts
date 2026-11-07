/** Thrown when a required secret is missing or malformed. The message names variables, never values. */
export class ConfigError extends Error {}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;
/** Lowercase FQDN with at least two labels; no scheme, port, path or trailing dot. */
const LOWERCASE_FQDN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The owner's numeric GitHub user ID. Throws unless OWNER_GITHUB_USER_ID is a positive integer. */
export function ownerGithubUserId(env: Env): number {
  const raw = env.OWNER_GITHUB_USER_ID;
  const id = Number(raw);
  if (typeof raw !== "string" || !POSITIVE_INTEGER.test(raw) || !Number.isSafeInteger(id)) {
    throw new ConfigError("OWNER_GITHUB_USER_ID must be a positive integer");
  }
  return id;
}

/** The one hostname this connector serves. Throws unless CONNECTOR_HOSTNAME is a lowercase FQDN. */
export function connectorHostname(env: Env): string {
  if (!isHostname(env.CONNECTOR_HOSTNAME)) {
    throw new ConfigError("CONNECTOR_HOSTNAME must be a lowercase fully qualified hostname");
  }
  return env.CONNECTOR_HOSTNAME;
}

function isHostname(value: unknown): value is string {
  return typeof value === "string" && LOWERCASE_FQDN.test(value);
}

const DEFAULT_AUDIT_RETENTION_DAYS = 90;
const MAX_AUDIT_RETENTION_DAYS = 365;

/**
 * Days the audit log keeps an entry: AUDIT_RETENTION_DAYS, rendered from
 * `connector.auditRetentionDays` in config/settings.json, or 90 when unset. Throws unless it is a
 * whole number from 1 to 365.
 */
export function auditRetentionDays(env: { AUDIT_RETENTION_DAYS?: string }): number {
  const raw = env.AUDIT_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_AUDIT_RETENTION_DAYS;
  const days = Number(raw);
  if (!POSITIVE_INTEGER.test(raw) || days > MAX_AUDIT_RETENTION_DAYS) {
    throw new ConfigError(`AUDIT_RETENTION_DAYS must be a whole number of days from 1 to ${MAX_AUDIT_RETENTION_DAYS}`);
  }
  return days;
}

/** Checks every secret the connector needs, so a misconfigured deploy fails closed on every request. */
export function checkConfig(env: Env): void {
  ownerGithubUserId(env);
  const invalid: string[] = [];
  if (typeof env.GITHUB_CLIENT_ID !== "string" || env.GITHUB_CLIENT_ID === "") invalid.push("GITHUB_CLIENT_ID");
  if (typeof env.GITHUB_CLIENT_SECRET !== "string" || env.GITHUB_CLIENT_SECRET === "") invalid.push("GITHUB_CLIENT_SECRET");
  if (typeof env.COOKIE_ENCRYPTION_KEY !== "string" || !HEX_32_BYTES.test(env.COOKIE_ENCRYPTION_KEY)) {
    invalid.push("COOKIE_ENCRYPTION_KEY");
  }
  if (typeof env.GRAPH_TOKEN_KEY !== "string" || !HEX_32_BYTES.test(env.GRAPH_TOKEN_KEY)) invalid.push("GRAPH_TOKEN_KEY");
  if (!isHostname(env.CONNECTOR_HOSTNAME)) invalid.push("CONNECTOR_HOSTNAME");
  if (invalid.length > 0) throw new ConfigError(`invalid connector secrets: ${invalid.join(", ")}`);
}
