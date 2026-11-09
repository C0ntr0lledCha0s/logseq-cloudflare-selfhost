-- service_tokens.access may also be 'write-no-delete': a token that writes but whose deletes the
-- connector refuses (design docs/superpowers/specs/2026-11-08-service-token-write-no-delete-design.md
-- §3.6). Until the enforcement commit, verifyServiceToken still accepts only 'read' and 'write', so a
-- 'write-no-delete' row cannot authenticate before its deletes are refused.
--
-- Why a rebuild: SQLite cannot alter a CHECK in place, so the table is copied into one with the new
-- CHECK, dropped and renamed. The column list is 0006's plus 0007's updated_at, in the same order, and
-- both sides of the INSERT name every column, so no value can shift column. The UNIQUE on name stays
-- inline; dropping the table drops service_tokens_hash, so it is recreated with the same name. The
-- CHECK is an OR chain, as in 0006, not IN (...), which bills an extra row on every INSERT and UPDATE
-- (see 0004). No foreign key refers to service_tokens, and no trigger or view uses it.
--
-- Cost, measured from D1 meta with two rows (test/service-tokens.test.ts "migration 0008" pins it):
-- CREATE reads 1 and writes 4; the INSERT ... SELECT reads 2 and writes 6 (each row with its primary
-- key and name index entries); DROP reads 27 and writes 0; RENAME reads 86 and writes 12 (schema
-- rows); the hash index reads 6 and writes 3. In all about 122 rows read and 25 written, once; only
-- the INSERT and the index grow with the rows, and the owner holds a handful of tokens. Every later
-- statement costs what it did before: findByHash still reads 1 row on a hit and 0 on a miss.
CREATE TABLE service_tokens_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  graph_ids TEXT NOT NULL CHECK(json_valid(graph_ids) AND json_type(graph_ids) = 'array'),
  access TEXT NOT NULL CHECK(access = 'read' OR access = 'write-no-delete' OR access = 'write'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
  last_used_at INTEGER,
  revoked_at INTEGER,
  updated_at INTEGER
);
INSERT INTO service_tokens_new (id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at, updated_at)
  SELECT id, name, token_hash, owner_id, graph_ids, access, created_at, expires_at, last_used_at, revoked_at, updated_at FROM service_tokens;
DROP TABLE service_tokens;
ALTER TABLE service_tokens_new RENAME TO service_tokens;
CREATE UNIQUE INDEX service_tokens_hash ON service_tokens(token_hash);
