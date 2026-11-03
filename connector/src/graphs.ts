import { aesKeyFromHex, base64url, fromBase64url } from "./crypto";

export type GraphMode = "read" | "write";
export type GraphPermission = "read" | "write" | "both";

/** A connected graph as the rest of the connector sees it. Deliberately has no token field. */
export interface GraphRecord {
  alias: string;
  graphId: string;
  graphName: string;
  mode: GraphMode;
  permission: GraphPermission;
  /** The token's expiry as the owner entered it (ISO-8601 date, YYYY-MM-DD), or null when unknown. */
  expiresAt: string | null;
  /** ISO-8601 UTC, or null if never used. */
  lastUsedAt: string | null;
}

export type NewGraph = Omit<GraphRecord, "lastUsedAt"> & { token: string };
export type GraphPatch = Partial<Pick<GraphRecord, "alias" | "mode" | "permission" | "expiresAt">>;

const DAY_MS = 86_400_000;
/** Token expiries this close (in days) or closer are flagged to the owner. */
export const EXPIRY_WARN_DAYS = 30;

/** Days from `now` until an expiry date (YYYY-MM-DD, midnight UTC), rounded up; 0 or less once expired. */
export function daysUntilExpiry(expiresAt: string, now: number): number {
  return Math.ceil((Date.parse(expiresAt) - now) / DAY_MS);
}

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN_PATTERN = /^logseq_pat_[A-Za-z0-9_-]+$/;
/** Identifies the GRAPH_TOKEN_KEY generation used for a row; there is only one so far. */
const KEY_ID = "k1";

/** Trims once, then requires a well-formed Logseq PAT. Throws rather than repairing. */
export function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("token has unexpected characters (stray whitespace or newline?)");
  return token;
}

/** Lowercases, turns every run of non-alphanumerics into one `-`, then requires the alias pattern. */
export function normalizeAlias(raw: string): string {
  const alias = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!ALIAS_PATTERN.test(alias)) throw new Error(`alias must match ${ALIAS_PATTERN} after normalization`);
  return alias;
}

interface Row {
  alias: string;
  graph_id: string;
  graph_name: string;
  mode: GraphMode;
  permission: GraphPermission;
  expires_at: string | null;
  last_used_at: string | null;
}

const RECORD_COLUMNS = "alias, graph_id, graph_name, mode, permission, expires_at, last_used_at";

function toRecord(row: Row): GraphRecord {
  return {
    alias: row.alias,
    graphId: row.graph_id,
    graphName: row.graph_name,
    mode: row.mode,
    permission: row.permission,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Graphs and their PATs in D1. Tokens are AES-GCM encrypted with a random 12-byte IV per write;
 * `token_ct` and `token_iv` are stored as unpadded base64url. The graph ID is bound as associated
 * data, so a ciphertext copied onto another graph's row fails to decrypt.
 */
export class GraphStore {
  private readonly key: Promise<CryptoKey>;

  /** Throws unless `keyHex` is 64 hex characters (the `GRAPH_TOKEN_KEY` secret). */
  constructor(
    private readonly db: D1Database,
    keyHex: string,
  ) {
    if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("GRAPH_TOKEN_KEY must be 64 hex characters (32 bytes)");
    this.key = aesKeyFromHex(keyHex, "GRAPH_TOKEN_KEY");
  }

  async list(): Promise<GraphRecord[]> {
    const { results } = await this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM graphs ORDER BY alias`).all<Row>();
    return results.map(toRecord);
  }

  async get(alias: string): Promise<GraphRecord | null> {
    const row = await this.db.prepare(`SELECT ${RECORD_COLUMNS} FROM graphs WHERE alias = ?`).bind(alias).first<Row>();
    return row ? toRecord(row) : null;
  }

  /** The decrypted PAT. Throws if the alias is unknown or the ciphertext does not authenticate. */
  async token(alias: string): Promise<string> {
    const row = await this.db
      .prepare("SELECT graph_id, token_ct, token_iv, key_id FROM graphs WHERE alias = ?")
      .bind(alias)
      .first<{ graph_id: string; token_ct: string; token_iv: string; key_id: string }>();
    if (!row) throw new Error(`unknown graph alias: ${alias}`);
    if (row.key_id !== KEY_ID) throw new Error(`unsupported token key id: ${row.key_id}`);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(row.token_iv), additionalData: new TextEncoder().encode(row.graph_id) },
      await this.key,
      fromBase64url(row.token_ct),
    );
    return new TextDecoder().decode(plain);
  }

  /** Rejects an invalid alias or token, a duplicate alias, and a graph ID that is already connected. */
  async add(rec: NewGraph): Promise<void> {
    if (!ALIAS_PATTERN.test(rec.alias)) throw new Error(`alias must match ${ALIAS_PATTERN}`);
    const token = normalizeToken(rec.token);
    if (await this.get(rec.alias)) throw new Error(`graph alias already exists: ${rec.alias}`);
    const existing = await this.db.prepare("SELECT alias FROM graphs WHERE graph_id = ?").bind(rec.graphId).first();
    if (existing) throw new Error("graph is already connected under another alias");
    const sealed = await this.seal(token, rec.graphId);
    await this.db
      .prepare(
        `INSERT INTO graphs (alias, graph_id, graph_name, mode, permission, expires_at, token_ct, token_iv, key_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        rec.alias,
        rec.graphId,
        rec.graphName,
        rec.mode,
        rec.permission,
        rec.expiresAt,
        sealed.ct,
        sealed.iv,
        KEY_ID,
        new Date().toISOString(),
      )
      .run();
  }

  /** A renamed alias is normalized and must be unused. Throws if `alias` does not exist. */
  async update(alias: string, patch: GraphPatch): Promise<void> {
    if (!(await this.get(alias))) throw new Error(`unknown graph alias: ${alias}`);
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.alias !== undefined) {
      const next = normalizeAlias(patch.alias);
      if (next !== alias && (await this.get(next))) throw new Error(`graph alias already exists: ${next}`);
      sets.push("alias = ?");
      values.push(next);
    }
    if (patch.mode !== undefined) {
      sets.push("mode = ?");
      values.push(patch.mode);
    }
    if (patch.permission !== undefined) {
      sets.push("permission = ?");
      values.push(patch.permission);
    }
    if (patch.expiresAt !== undefined) {
      sets.push("expires_at = ?");
      values.push(patch.expiresAt);
    }
    if (sets.length === 0) return;
    await this.db
      .prepare(`UPDATE graphs SET ${sets.join(", ")} WHERE alias = ?`)
      .bind(...values, alias)
      .run();
  }

  /** Swaps in a new PAT for the same graph. Throws if `graphId` is not the stored graph's. */
  async replaceToken(alias: string, token: string, graphId: string): Promise<void> {
    const current = await this.get(alias);
    if (!current) throw new Error(`unknown graph alias: ${alias}`);
    if (current.graphId !== graphId) throw new Error("token belongs to a different graph");
    const sealed = await this.seal(normalizeToken(token), current.graphId);
    await this.db
      .prepare("UPDATE graphs SET token_ct = ?, token_iv = ?, key_id = ? WHERE alias = ?")
      .bind(sealed.ct, sealed.iv, KEY_ID, alias)
      .run();
  }

  async remove(alias: string): Promise<void> {
    const result = await this.db.prepare("DELETE FROM graphs WHERE alias = ?").bind(alias).run();
    if (result.meta.changes === 0) throw new Error(`unknown graph alias: ${alias}`);
  }

  /** Records a use now. Throws if the alias does not exist; callers look it up first. */
  async touch(alias: string): Promise<void> {
    const result = await this.db
      .prepare("UPDATE graphs SET last_used_at = ? WHERE alias = ?")
      .bind(new Date().toISOString(), alias)
      .run();
    if (result.meta.changes === 0) throw new Error(`unknown graph alias: ${alias}`);
  }

  private async seal(token: string, graphId: string): Promise<{ ct: string; iv: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(graphId) },
      await this.key,
      new TextEncoder().encode(token),
    );
    return { ct: base64url(new Uint8Array(ct)), iv: base64url(iv) };
  }
}
