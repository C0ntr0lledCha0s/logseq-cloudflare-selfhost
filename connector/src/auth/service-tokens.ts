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

export type ServiceTokenAccess = "read" | "write-no-delete" | "write";

/**
 * The order of the access values, defined only here (spec 2026-11-08-service-token-write-no-delete
 * §3.2): `read` < `write-no-delete` < `write`. A higher rank may do everything a lower one may.
 */
export const MODE_RANK = { read: 0, "write-no-delete": 1, write: 2 } as const;

/** The rank of `access`. Throws for anything that is not a MODE_RANK key, so an unknown value never ranks. */
export function rank(access: ServiceTokenAccess): number {
  if (!Object.hasOwn(MODE_RANK, access)) throw new Error(`unknown service token access '${access}'`);
  return MODE_RANK[access];
}

/**
 * The access values a token may authenticate with. `write-no-delete` is stored (migration 0008) but
 * not yet accepted: the connector does not refuse its deletes until the enforcement stage, which
 * widens this to every MODE_RANK key. Anything else, a value written past the CHECK included, is
 * refused too, so an unknown access fails closed rather than acting as write.
 */
function acceptedAccess(access: unknown): access is "read" | "write" {
  return access === "read" || access === "write";
}

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
  /** When the owner last edited the scope (migration 0007); null when never edited. */
  updatedAt: number | null;
}

/** The part of a token the owner can edit: what `update` guards on and what it writes. */
export interface TokenScope {
  graphIds: string[];
  access: ServiceTokenAccess;
  expiresAt: number;
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
  updated_at?: number | null;
}

const PUBLIC_COLUMNS = "id, name, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at, updated_at";

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
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * The service_tokens table. Every statement uses `run` or `all`, so its D1 cost can be read from
 * `meta` (test/service-tokens.test.ts pins each: insert 4 written; hash lookup 1 read on a hit and 0
 * on a miss; touch 1 read and at most 1 written; revoke 1 read and 1 written; list about one read a row;
 * update 1 read and 1 written on a hit, 1 read and 0 written on a guard miss, 0 and 0 for an unknown id).
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
   * Replaces a token's graphs, access and expiry, and stamps `updated_at` (spec 2026-11-08 §3.3). One
   * conditional UPDATE: it writes only while the token is unrevoked and unexpired at `now` and still
   * holds exactly `before`, the values the caller's diff was computed from, so a second tab or a
   * disconnect's revokeForGraph landing in between makes it miss, and the edit fails closed rather
   * than overwriting a newer state or reviving a revoked token. `graph_ids` is compared as JSON text,
   * which round-trips because create and update both store JSON.stringify of a string array; another
   * order counts as a change. It takes no token and sets no token_hash, so an edit is never a
   * rotation. Throws, before any statement, if `after` would extend the expiry. True when it wrote.
   */
  async update(id: string, before: TokenScope, after: TokenScope, now: number): Promise<boolean> {
    const result = await this.updateStatement(id, before, after, now).run();
    return result.meta.changes > 0;
  }

  /**
   * `update`'s guarded UPDATE as a statement, unrun, for a `db.batch` that must commit it together
   * with the edit's audit row (AuditLog.tokenEditStatement). Throws as `update` does.
   */
  updateStatement(id: string, before: TokenScope, after: TokenScope, now: number): D1PreparedStatement {
    if (after.expiresAt > before.expiresAt) {
      throw new Error(`service token ${id}: an edit can only shorten the expiry, never extend it`);
    }
    return this.db
      .prepare(
        `UPDATE service_tokens
            SET graph_ids = ?, access = ?, expires_at = ?, updated_at = ?
          WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
            AND graph_ids = ? AND access = ? AND expires_at = ?`,
      )
      .bind(
        JSON.stringify(after.graphIds),
        after.access,
        after.expiresAt,
        now,
        id,
        now,
        JSON.stringify(before.graphIds),
        before.access,
        before.expiresAt,
      );
  }

  /**
   * Revokes every unrevoked token whose scope includes `graphId`, and answers how many. Disconnecting
   * a graph calls it, so reconnecting the same graph later restores no old token's access. It reads
   * every row (json_each has no index), which is a handful: the owner's own tokens.
   */
  async revokeForGraph(graphId: string, now: number): Promise<number> {
    const result = await this.db
      .prepare(
        "UPDATE service_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND EXISTS (SELECT 1 FROM json_each(service_tokens.graph_ids) WHERE json_each.value = ?)",
      )
      .bind(now, graphId)
      .run();
    return result.meta.changes;
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
 * learns a reason; a row whose access is not accepted (see `acceptedAccess`) gets it too. Logs nothing; the token and its hash never leave this function.
 */
export async function verifyServiceToken(env: Env, token: string, now: number): Promise<ServiceProps | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = await hashServiceToken(token);
  const row = await new ServiceTokenStore(env.DB).findByHash(hash);
  if (!row || !timingSafeEqual(row.tokenHash, hash)) return null;
  if (row.revokedAt !== null) refuse(`service token '${row.name}' was revoked`);
  if (row.expiresAt <= now) refuse(`service token '${row.name}' expired on ${new Date(row.expiresAt).toISOString().slice(0, 10)}`);
  if (!isOwner(row.ownerId, env)) refuse(`service token '${row.name}' belongs to a previous owner`);
  if (!acceptedAccess(row.access)) return null;
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
