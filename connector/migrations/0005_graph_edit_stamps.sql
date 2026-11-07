-- graphs.edit_stamps: whether the connector sends `x-logseq-edit-stamp: claude` on this graph's
-- writes, so the sync server stamps the blocks they create or change with editedBy and
-- claudeEditedAt (design docs/superpowers/specs/2026-11-07-claude-edit-stamps-editedby-design.md
-- §3.4). On (1) by default, so every graph already connected stamps after deploy; the owner turns it
-- off per graph in the wizard, and no MCP tool can change it.
--
-- Cost: a one-time ALTER on a table of a few rows, no backfill (the default fills existing rows) and
-- no trigger. GraphStore.resolve() reads the column from the row it already reads by primary key, so
-- a tool call reads no more rows than before (test/graphs.test.ts pins meta.rows_read at 1).
ALTER TABLE graphs ADD COLUMN edit_stamps INTEGER NOT NULL DEFAULT 1 CHECK(edit_stamps = 0 OR edit_stamps = 1);
