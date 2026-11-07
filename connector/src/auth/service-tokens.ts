import { ExternalTokenError } from "@cloudflare/workers-oauth-provider";
import { base64url, timingSafeEqual } from "../crypto";
import { isOwner } from "./github";

/**
 * Service tokens: `lsct_` bearers for unattended Claude Code cloud sessions (design
 * docs/superpowers/specs/2026-11-07-service-token-cloud-sessions-design.md §3.2, §3.6). D1 holds only
 * the SHA-256 of a token; the token itself is returned once, by `create`, and never stored.
 */

/** `lsct_` and the base64url of 32 random bytes: 48 characters, no colon (so OAuth KV never sees it). */
export const TOKEN_PATTERN = /^lsct_[A-Za-z0-9_-]{43}$/;
/** `last_used_at` is written at most once per token in this interval. */
export const TOUCH_INTERVAL_MS = 3_600_000;
export const MAX_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_DAYS = 90;

export type ServiceTokenAccess = "read" | "write";

/** A token as the wizard sees it. Deliberately has no hash field. */
export interface ServiceTokenRow {
  id: string;
  name: string;
  ownerId: number;
  graphIds: string[];
  access: ServiceTokenAccess;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** What verification needs from the row found by hash (§3.2 step 2). */
export interface ServiceTokenMatch {
  id: string;
  name: string;
  tokenHash: string;
  ownerId: number;
  graphIds: string[];
  access: ServiceTokenAccess;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface NewServiceToken {
  name: string;
  ownerId: number;
  graphIds: string[];
  access: ServiceTokenAccess;
  createdAt: number;
  expiresAt: number;
}

export function generateServiceToken(): string {
  return `lsct_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** SHA-256 of the whole token, as lower-case hex. A slow hash adds nothing for 256 random bits. */
export async function hashServiceToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Row {
  id: string;
  name: string;
  token_hash?: string;
  owner_id: number;
  graph_ids: string;
  access: ServiceTokenAccess;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const PUBLIC_COLUMNS = "id, name, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at";

function toRow(row: Row): ServiceTokenRow {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    graphIds: JSON.parse(row.graph_ids) as string[],
    access: row.access,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * The service_tokens table. Every statement uses `run` or `all`, so its D1 cost can be read from
 * `meta` (test/service-tokens.test.ts pins each: insert 4 written; hash lookup 1 read on a hit and 0
 * on a miss; touch 1 read and at most 1 written; revoke 1 read and 1 written; list about one read a row).
 */
export class ServiceTokenStore {
  constructor(private readonly db: D1Database) {}

  /** Inserts a new token and returns it with its id. This is the only time the token exists outside its holder. */
  async create(input: NewServiceToken): Promise<{ id: string; token: string }> {
    const id = crypto.randomUUID();
    const token = generateServiceToken();
    await this.db
      .prepare(
        "INSERT INTO service_tokens (id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        input.name,
        await hashServiceToken(token),
        input.ownerId,
        JSON.stringify(input.graphIds),
        input.access,
        input.createdAt,
        input.expiresAt,
      )
      .run();
    return { id, token };
  }

  async get(id: string): Promise<ServiceTokenRow | null> {
    const { results } = await this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM service_tokens WHERE id = ?`).bind(id).all<Row>();
    return results[0] ? toRow(results[0]) : null;
  }

  /** Ordered by name, which the unique `name` index serves (an unindexed ORDER BY reads twice the rows). */
  async list(): Promise<ServiceTokenRow[]> {
    const { results } = await this.db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM service_tokens ORDER BY name`).all<Row>();
    return results.map(toRow);
  }

  /** Whether any token, revoked or not, has this name. A lookup on the unique name index: 0 rows read on a miss. */
  async nameInUse(name: string): Promise<boolean> {
    const { results } = await this.db.prepare("SELECT id FROM service_tokens WHERE name = ?").bind(name).all();
    return results.length > 0;
  }

  /** Deletes one row. Only the wizard's failed read-back uses it; revoked and expired rows stay listed. */
  async remove(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM service_tokens WHERE id = ?").bind(id).run();
  }

  /** The row whose hash matches, or null. Callers still compare the hash in constant time (§3.2 step 3). */
  async findByHash(hash: string): Promise<ServiceTokenMatch | null> {
    const { results } = await this.db
      .prepare(
        "SELECT id, name, token_hash, owner_id, graph_ids, access, expires_at, last_used_at, revoked_at FROM service_tokens WHERE token_hash = ?",
      )
      .bind(hash)
      .all<Row>();
    const row = results[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      tokenHash: row.token_hash!,
      ownerId: row.owner_id,
      graphIds: JSON.parse(row.graph_ids) as string[],
      access: row.access,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  /** Sets `revoked_at` once; a second revoke keeps the first time. True when this call revoked it. */
  async revoke(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE service_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, id)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Records use at most once per TOUCH_INTERVAL_MS. The condition is in the UPDATE, so two isolates
   * touching in the same hour write once. True when this call wrote.
   */
  async touch(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE service_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)")
      .bind(now, id, now - TOUCH_INTERVAL_MS)
      .run();
    return result.meta.changes > 0;
  }
}

/** What a verified token carries to `mcpApiHandler` as `ctx.props` (design §3.2 step 5). */
export interface ServiceProps {
  kind: "service";
  tokenId: string;
  name: string;
  /** The token's owner; `mcpApiHandler` checks it against OWNER_GITHUB_USER_ID again. */
  githubUserId: number;
  graphIds: string[];
  access: ServiceTokenAccess;
  /** From the verify read, so the handler can throttle the touch without another read. */
  lastUsedAt: number | null;
}

function refuse(description: string): never {
  throw new ExternalTokenError("invalid_token", { description, statusCode: 401 });
}

/**
 * The provider's `resolveExternalToken` check for a bearer (design §3.2). In order: the shape (a
 * bearer that is not a service token never reaches D1), the lookup by the full hash, a constant-time
 * compare, and only then the reasons, revoked, expired and previous owner, each thrown as a 401 that
 * names the token. `null` is the provider's generic `Invalid access token`, so a wrong token never
 * learns a reason. Logs nothing; the token and its hash never leave this function.
 */
export async function verifyServiceToken(env: Env, token: string, now: number): Promise<ServiceProps | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = await hashServiceToken(token);
  const row = await new ServiceTokenStore(env.DB).findByHash(hash);
  if (!row || !timingSafeEqual(row.tokenHash, hash)) return null;
  if (row.revokedAt !== null) refuse(`service token '${row.name}' was revoked`);
  if (row.expiresAt <= now) refuse(`service token '${row.name}' expired on ${new Date(row.expiresAt).toISOString().slice(0, 10)}`);
  if (!isOwner(row.ownerId, env)) refuse(`service token '${row.name}' belongs to a previous owner`);
  return {
    kind: "service",
    tokenId: row.id,
    name: row.name,
    githubUserId: row.ownerId,
    graphIds: row.graphIds,
    access: row.access,
    lastUsedAt: row.lastUsedAt,
  };
}
