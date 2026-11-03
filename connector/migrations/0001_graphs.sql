-- Connected Logseq graphs. The graph PAT is stored only as AES-GCM ciphertext
-- (token_ct, token_iv: base64url); key_id names the GRAPH_TOKEN_KEY generation.
-- Timestamps are ISO-8601 UTC strings.
CREATE TABLE graphs (
  alias TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL UNIQUE,
  graph_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('read','write')),
  permission TEXT NOT NULL CHECK(permission IN ('read','write','both')),
  expires_at TEXT,
  token_ct TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
