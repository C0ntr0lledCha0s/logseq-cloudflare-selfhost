-- semantic_state.blocks is the graph's number of rows in semantic_blocks, kept exact by the triggers
-- below. The vector cap check (on every indexer page that adds blocks), semantic_search and
-- semantic_index_status read these few state rows instead of count(*) over semantic_blocks, which
-- reads every row (D1 bills rows read: about 5,000 per count on a 5,000-block graph).
ALTER TABLE semantic_state ADD COLUMN blocks INTEGER NOT NULL DEFAULT 0;

UPDATE semantic_state
SET blocks = (SELECT count(*) FROM semantic_blocks b WHERE b.graph_id = semantic_state.graph_id);

-- The indexer leases a graph, creating its state row, before writing any of its blocks, and drops
-- the state row only once the graph has no blocks left. A block without a state row would leave the
-- count wrong, so it is refused.
CREATE TRIGGER semantic_blocks_count_insert AFTER INSERT ON semantic_blocks
BEGIN
  SELECT RAISE(ABORT, 'semantic_blocks row without a semantic_state row')
  WHERE NOT EXISTS (SELECT 1 FROM semantic_state WHERE graph_id = NEW.graph_id);
  UPDATE semantic_state SET blocks = blocks + 1 WHERE graph_id = NEW.graph_id;
END;

-- An upsert that updates an existing row fires neither trigger, and never changes graph_id.
CREATE TRIGGER semantic_blocks_count_delete AFTER DELETE ON semantic_blocks
BEGIN
  UPDATE semantic_state SET blocks = blocks - 1 WHERE graph_id = OLD.graph_id;
END;
