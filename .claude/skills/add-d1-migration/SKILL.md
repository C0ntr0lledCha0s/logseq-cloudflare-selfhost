---
name: add-d1-migration
description: Change the connector's D1 schema (a table, column, index or trigger) with a numbered migration in connector/migrations. Use when connector code needs new stored state, or a query needs an index or a maintained count to stay within the Free plan's D1 reads.
---

# Add a D1 migration

The connector's one D1 database holds sign-ins, encrypted graph tokens and the semantic index's state. A bad migration can lock the owner out, so treat it with care.

- `scripts/deploy-connector.sh` runs `wrangler d1 migrations apply --remote` on every deploy.
- The tests apply the same files (`vitest.config.ts` → `readD1Migrations`, `test/apply-migrations.ts`).

## Steps

1. Add `connector/migrations/00NN_what_it_does.sql`, numbered after the highest existing file. Open it with a comment explaining why the change exists and what it costs (see `0003_semantic_block_counts.sql`).
2. **Additive only.** Add tables, columns with defaults, indexes and triggers. Don't drop or rename anything the deployed code still reads: deploy order is migrate first, then the Worker.
3. **Backfill in the migration** when a new column derives from existing rows, as 0003 does for `blocks`.
4. **Cost.** A backfill and every trigger read and write rows. Estimate both against the live sizes (about 5,800 semantic blocks), and say whether a trigger adds writes to a hot path.
5. **Test** that the new code works on a database migrated from the previous schema with existing rows, not only on an empty one.
6. **Gate:** `scripts/check.sh`.

## Rules

- **Never edit a migration that has shipped.** D1 records applied migrations by name.
- **No `count(*)` or scans on hot paths.** Keep a maintained count instead (`semantic_state.blocks`). See `docs/solutions/cost/d1-reads-from-indexer-scans.md`.
