-- Semantic search (docs/superpowers/specs/2026-11-04-semantic-search-design.md). Inert until the
-- AI and VECTORIZE bindings exist. Timestamps are ISO-8601 UTC strings, except lease_until (ms).

-- One row per indexed block. vector_id is the block's Vectorize ID, derived from graph and block
-- (src/semantic/document.ts). The text columns are what semantic_search shows; hash is SHA-256 of
-- the embedded document, so unchanged blocks are never embedded again.
CREATE TABLE semantic_blocks (
  vector_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  block_uuid TEXT NOT NULL,
  page_uuid TEXT NOT NULL,
  page_title TEXT NOT NULL,
  breadcrumb TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE UNIQUE INDEX semantic_blocks_graph_block ON semantic_blocks (graph_id, block_uuid);

-- The indexer's position per graph (by graph ID, so renaming an alias keeps it). t and epoch come
-- from the sync server's listBlockChanges; t is null until a full listing completes. cursor and
-- last_uuid belong to the listing in progress, which started at pending_t.
CREATE TABLE semantic_state (
  graph_id TEXT PRIMARY KEY,
  epoch TEXT,
  t INTEGER,
  pending_t INTEGER,
  cursor TEXT,
  last_uuid TEXT,
  status TEXT NOT NULL CHECK(status IN ('building','ready','full','error','skipped-e2ee')),
  error TEXT,
  lease_until INTEGER NOT NULL,
  indexed_at TEXT
);
