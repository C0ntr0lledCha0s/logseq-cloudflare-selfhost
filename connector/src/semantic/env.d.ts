// Optional bindings for semantic search. They exist only when SEMANTIC_SEARCH_ENABLED rendered them
// (scripts/render-connector-wrangler.mjs), so they are declared here rather than in the generated
// worker-configuration.d.ts, whose test config has none of them.
interface Env {
  AI?: Ai;
  VECTORIZE?: Vectorize;
  SEMANTIC_MAX_VECTORS?: string;
}
