-- audit_log records every write, move and delete call the connector runs, owner-only (design
-- docs/superpowers/specs/2026-11-07-connector-write-audit-log-design.md §3.2). A call inserts a
-- `pending` row holding its before-snapshot, then updates it by id with the outcome. Nothing but these
-- columns is stored: never the raw tool arguments, the block text a write sends, or any token.
--
-- Cost, measured from D1 meta (test/audit-log.test.ts pins each): the INSERT writes 2 rows (the row
-- and its index entry) and reads 0, the UPDATE by primary key writes 1 and reads 1. The status CHECK
-- is an OR chain, not IN (...): an IN list of three or more values builds an ephemeral table that D1
-- bills as one more row read on every INSERT and UPDATE. The hourly purge reads the oldest row (1 read)
-- and stops when it is not older than the retention cutoff; otherwise it deletes at most 500 of the
-- oldest rows by id range (at most 501 more read, 1 written per row). No backfill, no triggers.
--
-- id has no AUTOINCREMENT: SQLite gives max(id) + 1, and the purge only removes the oldest rows, so
-- id order and `at` order agree and the purge can walk by id.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,           -- grows with time; the purge relies on it
  at INTEGER NOT NULL,              -- ms since the epoch, set by the Worker at begin
  graph_id TEXT,                    -- null when the alias didn't resolve
  alias TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('write','read')),
  status TEXT NOT NULL CHECK(status = 'pending' OR status = 'ok' OR status = 'error' OR status = 'refused'),
  dry_run INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  client TEXT,
  session TEXT,
  addressed TEXT,                   -- JSON array of the UUIDs or selectors the call named
  pages TEXT,                       -- lower-cased page titles and UUIDs, '\n'-joined, for the page filter
  targets TEXT,                     -- JSON AffectedTarget[] from item 17's describeWrite
  before TEXT,                      -- JSON {source, truncated?, e2ee?, error?, data}
  error TEXT,                       -- the ToolError message, which names the entry and reason
  rows_written INTEGER,             -- this entry's own D1 cost (3.7)
  rows_read INTEGER
);
CREATE INDEX audit_log_graph_at ON audit_log(graph_id, at);
