/**
 * The connector's cron schedules. scripts/render-connector-wrangler.mjs renders them into the
 * Worker's triggers (a test keeps the two in step), and `scheduled` in src/index.ts dispatches on
 * which one fired.
 */

/** Rebuilds every graph's kb_index cache. Always rendered. */
export const KB_INDEX_CRON = "0 * * * *";

/** Runs the semantic indexer, each run bounded (design 2026-11-04 §6). Rendered only with semantic search on. */
export const SEMANTIC_CRON = "* * * * *";
