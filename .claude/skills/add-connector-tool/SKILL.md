---
name: add-connector-tool
description: Add or change an MCP tool the connector exposes to Claude, either generated from the sync server's OpenAPI or hand-written in connector/src/tools. Use for a new tool, a renamed or re-shaped tool, a new argument or default, or changed tool text (description, connector_help).
---

# Add or change a connector tool

There are two kinds of tool:

- **Generated tools** come from the vendored upstream `openapi.json` (`connector/src/tools/semantic.ts`, filtered and named in `spec.mjs`). To add one, add the operation upstream with a patch (`add-upstream-patch`), re-vendor, and give it an entry in `ANNOTATIONS` in `spec.mjs` (upstream's method-derived hints are ignored; a tool with no entry fails the manifest and the Worker). `EXCLUDED_OPERATIONS` in `spec.mjs` hides operations Claude shouldn't call.
- **Hand-written tools** are registered with `server.registerTool` in `connector/src/tools/` (`handwritten.ts`, `kb-index.ts`, `semantic-search.ts` and `assets.ts`, wired up in `src/mcp.ts`). Use one when the tool combines calls, reads the connector's own storage (D1, KV, Vectorize) or must not reach the sync server.

## Steps for a hand-written tool

1. **Test first** in `connector/test/<area>.test.ts`. Call the tool through the MCP handler as the existing tests do, with `SYNC` stubbed at the service boundary only. Assert what Claude gets back, and what was stored.
2. **Register it** with:
   - a description that says what it returns and when to use it,
   - a zod `inputSchema` (the graph argument uses `ALIAS_PATTERN` and `GRAPH_PARAM_DESCRIPTION` from `spec.mjs`),
   - `annotations: annotationsFor("<name>")`, with the tool's entry added to `ANNOTATIONS` in `spec.mjs` (one of `READ`, `DESTRUCTIVE`, `DESTRUCTIVE_IDEMPOTENT` or `ADDITIVE`; `openWorldHint` only when it fetches outside the graph), and
   - its body wrapped in `runTool`.
3. **List it** in `HANDWRITTEN_TOOLS` in `spec.mjs` (and `SEMANTIC_TOOLS` if it depends on semantic search), then run `npm --prefix connector run update:manifest`.
4. **Teach Claude.** Update `connector_help` (`CONNECTOR_HELP` in `handwritten.ts`) if the tool changes how Claude should work, and README §11.8.
5. **Cost.** Write down rows, operations and neurons per call (REVIEW.md, *Cost*). Responses stay compact: IDs and counts, not echoed trees.
6. **Gate:** `scripts/check.sh`. It needs `connector/vendor`; see `CLAUDE.md` → Commands.

## Rules

- **Changing a tool is a contract change.** Renamed arguments and changed defaults break claude.ai sessions silently, so prefer adding over changing, and give old callers a clear error.
- **After deploy, a new tool shows up in claude.ai only once the connector is reconnected.** Say so in the PR's live verification steps.
