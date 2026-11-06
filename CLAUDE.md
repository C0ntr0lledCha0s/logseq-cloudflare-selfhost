# logseq-cloudflare-selfhost

This repo self-hosts Logseq's DB sync server on Cloudflare, plus `logseq-connector`, a remote MCP server that lets claude.ai and Claude Code read and write the owner's graphs. The README covers setup and operations. This file covers how to change the code safely.

## Map

| Path | What it is |
|---|---|
| `UPSTREAM_REF`, `patches/NNNN-*.patch` | The sync server is upstream `logseq/logseq` (`deps/db-sync`) at `UPSTREAM_REF`, with the numbered patches applied in order by `scripts/fetch-upstream.sh`. Every semantic API fix (handlers, routes, sync) is a patch. |
| `connector/` | The MCP Worker (TypeScript, vitest with `@cloudflare/vitest-pool-workers`). Tools are generated from the vendored upstream `openapi.json` (`src/tools/semantic.ts`, `spec.mjs`), plus hand-written ones (`handwritten.ts`, `kb-index.ts`, `semantic-search.ts`, `assets.ts`). `connector_help` text and `tools-manifest.json` are part of the contract with Claude. |
| `connector/src/semantic/` | The semantic index: Workers AI embeddings, Vectorize, D1 state, cron indexer. |
| `connector/migrations/` | D1 migrations (sign-ins, graph tokens and semantic state share one database). |
| `scripts/` | Bash and Node build, deploy, backup and usage scripts. Every script has a `*.test.mjs` next to it. |
| `infra/` | OpenTofu (Cloudflare provider v5). |
| `config/settings.json` | Non-secret settings: plan, connector and semantic switches. |
| `.github/workflows/` | `ci`, `deploy` (merging to main deploys), `backup`, `usage`, `bump-upstream`. |
| `docs/superpowers/specs`, `docs/superpowers/plans` | Design specs and implementation plans, named `YYYY-MM-DD-slug(-design).md`. |
| `docs/solutions/` | Learnings from past bugs and features (the compound loop). Read the relevant ones before you investigate or design. |
| `docs/lanes/` | How staged work runs: lanes, stages, gates, reviews. |
| `REVIEW.md` | The review checklist: defect classes found more than once, and known false positives. |
| `.claude/` | Lane workflows, subagents and skills (see below). |

## Commands

- `scripts/check.sh` is the gate every lane uses. It runs the scripts' unit tests, the connector tests, typecheck and tools-manifest check (when `connector/vendor/` exists), and `tofu fmt`. It names each check it skipped and why. Add `--upstream` when `patches/` changed.
- `npm test` runs the scripts' unit tests only (fast, needs nothing built).
- Connector checks need the vendored upstream API: `scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream`. The build needs mise's toolchain (Java, the Clojure CLI, pnpm) and takes a while. CI builds it on every push and PR, and also runs upstream's own db-sync suite, which includes the tests the patches add.
- `npm --prefix connector run update:manifest` rewrites `tools-manifest.json` after a tool is added, removed or renamed.

## Recipes

Use these project skills for the common kinds of change:

- `add-upstream-patch` for anything in the sync server or semantic API (`patches/`)
- `add-connector-tool` for a new or changed MCP tool
- `add-d1-migration` for the connector's database

`REVIEW.md` lists the defect classes this repo has shipped. Read the sections for your area before you call work done.

## Conventions

- **Branches and commits.** Use `fix/…`, `feat/…`, `docs/…` and `chore/…` branches. Commits follow `type(scope): what changed` (scopes: `api`, `sync`, `connector`, `semantic`, `deploy`, `infra`). The body explains the cause, the fix and what the tests prove, in plain prose.
- **Tests run the real thing, and were seen to fail.** A regression test must fail without the fix (quote the failure in the PR) and exercise the real handler, outliner or SQL. A stubbed outliner once hid where `move_blocks` put blocks (`docs/solutions/testing/stubbed-outliner-hid-block-placement.md`).
- **Errors name the entry and reason.** A refused batch says which entry and why (`entry 0: block not found`), never one generic message.
- **No silent success.** A write the server accepts must read back. If a value can't be applied, refuse the whole call up front.
- **The Free plan is a hard budget.** The account-wide daily caps are 100k Worker requests, 5M D1 rows read, 100k D1 rows written and 10k Workers AI neurons. The front Worker gets 10 ms CPU per request, and the Free plan stores 5M Vectorize dimensions. Going over stops sign-ins and graph tokens until 00:00 UTC. Count rows read per request and per cron run in any change that touches D1 (REVIEW.md, *Cost*).
- **The contract with Claude.** When a tool's behaviour changes, update its description, `connector_help`, `tools-manifest.json`, README §11.8, and the "Logseq skill note" in the PR body. The skill note covers what the owner's own Logseq skill needs to change.
- **Claims only for checks run on HEAD.** A PR's verification section names the commit its checks ran on, and repeats what `scripts/check.sh` skipped.
- **Never commit or print secrets.** `.env.local` and the `production` environment hold them. Docs and tests use `sync.example.com` and `mcp.example.com`.
- **Writing.** UK/NZ English. Use plain sentences and say what something does, not how impressive it is.

## Gotchas

Traps anyone changing the code would hit. The compound step adds an entry when a lesson recurs (classes that review should check go to `REVIEW.md` instead). Each entry links its `docs/solutions` write-up.

- The Worker must seed the process-wide max order key before it writes. Otherwise new value blocks can reuse an existing order key and reorder a page (`docs/solutions/sync/order-key-not-seeded-for-server-writes.md`).
- Path parameters are decoded by the router. Re-encode them when forwarding, because qualified idents contain `/` (`docs/solutions/api/qualified-ident-path-params-404.md`).
- A batch must replay as one transaction with one tx id. Mixed tx ids make clients replay retract and add in the wrong order (`docs/solutions/sync/batch-replayed-with-mixed-tx-ids.md`).
- "It doesn't reproduce" and "the read hid it" are common outcomes. Check the read path before you blame the write (`docs/solutions/api/read-hid-built-in-properties.md`).
- The outliner does not check closed values (choices) or a property's classes on server writes (`*closed-values-validate?*` defaults to false), so the semantic handler must resolve a title inside the property's allowed values itself (`docs/solutions/api/title-resolves-outside-allowed-values.md`).
- Feeds end with a null next-cursor, and `count(*)` scans rows on D1. Both have cost the Free plan before (`docs/solutions/cost/d1-reads-from-indexer-scans.md`).

## Lanes

Staged work runs as a lane. Start one with `/lane` (it routes to the right workflow), or run the saved workflow directly. Details are in `docs/lanes/README.md`.

| Lane | Workflow | Use for |
|---|---|---|
| Bug | `lane-bug` | A defect: preconditions → investigate (the root cause is challenged by skeptics) → failing test → fix → review rounds → docs → compound and retro → closeout |
| Feature | `lane-feature` | An enhancement: preconditions → design panel → spec (stops for approval) → plan → staged build → review rounds → docs → compound and retro → closeout |
| Spike | `lane-spike` | A question: multi-angle research → write-up in `docs/spikes/` → challenge → compound |
| Review | `lane-review` | Correctness, integrity, tests, efficiency, security (and contract) lenses. Skeptics verify each serious finding, and open findings are re-checked by id. The other lanes call it every round. |

Lane agents commit as they go, one commit per stage. `/lane` pushes, and opens a PR only when asked.

Issues live on a page in the owner's Logseq graph (by default **Logseq Connector Issues**). The graph and page are set in the untracked `.claude/lanes.local.json` (copy `.claude/lanes.local.example.json`); never commit the graph's name or page UUIDs. The lanes read that page. They never write to Logseq: `/lane` shows a draft update and writes it only when the owner says yes.
