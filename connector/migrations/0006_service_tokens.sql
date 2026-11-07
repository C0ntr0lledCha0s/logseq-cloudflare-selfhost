-- service_tokens: bearer tokens for unattended Claude Code cloud sessions and scheduled tasks
-- (design docs/superpowers/specs/2026-11-07-service-token-cloud-sessions-design.md §3.6). The owner
-- creates one in the wizard, scoped to named graphs (graph_ids, by graph_id so an alias rename keeps
-- the scope) and to read or write. Only the SHA-256 hex of the token is stored, never the token.
--
-- Cost, measured from D1 meta (test/service-tokens.test.ts pins each): the INSERT writes 4 rows (the
-- row and its three index entries: primary key, unique name, unique token_hash) and reads 0. The
-- lookup by token_hash reads 1 row on a hit and 0 on a miss. The conditional last-used UPDATE reads 1
-- row whether or not it writes, and writes at most 1 an hour per token. Revoke reads 1 and writes 1.
-- The wizard lists ORDER BY name, which the unique name index serves (about one row read per token;
-- ordering by an unindexed column reads twice that). The CHECKs are OR chains, not IN (...), which
-- would bill an extra row on every INSERT and UPDATE (see 0004). No trigger and no backfill.
CREATE TABLE service_tokens (
  id TEXT PRIMARY KEY,                       -- random, shown in the wizard and revoke URL; not a secret
  name TEXT NOT NULL UNIQUE,                 -- [a-z0-9-]{1,40}, checked by the wizard
  token_hash TEXT NOT NULL,                  -- SHA-256 hex of the token; the token itself is never stored
  owner_id INTEGER NOT NULL,
  graph_ids TEXT NOT NULL CHECK(json_valid(graph_ids) AND json_type(graph_ids) = 'array'),
  access TEXT NOT NULL CHECK(access = 'read' OR access = 'write'),
  created_at INTEGER NOT NULL,               -- ms since the epoch
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX service_tokens_hash ON service_tokens(token_hash);
