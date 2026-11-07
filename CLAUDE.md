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
| `scripts/setup.sh` | The guided setup, one command from a fork to a deployed server (eight resumable stages). Orchestrates `doctor.sh`, `init-env.sh`, `run-deploy.sh` and `allow-user.sh`; it doesn't re-implement them. |
| `scripts/doctor.sh`, `doctor.mjs` | Read-only checks of the Cloudflare account, token, domain, GitHub repo and `.env.local`. One `ok`, `warn`, `skip` or `FAIL` line each. |
| `scripts/allow-user.sh`, `allow-user.mjs` | Claims the server (`--owner`) or adds a person, from the sync Worker's `user-not-allowed` log. Edits `DB_SYNC_ALLOWED_USERS` in `.env.local` after a backup. |
| `scripts/enable-connector.sh` | Turns the connector on after its GitHub OAuth app exists (secrets, `CONNECTOR_ENABLED` in both places, doctor, deploy). |
| `scripts/run-deploy.sh` | Starts the `deploy` workflow on `main` and follows it from the terminal. |
| `scripts/ensure-account.mjs` | Creates OpenTofu's state bucket and the `workers.dev` subdomain when missing. `deploy.yml` runs it before `tofu init`. |
| `scripts/lib/gh.sh` | `origin_repo` (the repo the `origin` remote points at, never the parent `gh` would pick in a fork clone), sourced by `setup.sh`, `enable-connector.sh`, `init-env.sh` and `run-deploy.sh`; `gh_try` and `gh_must`, used by the first two. |
| `config/token-permissions.json`, `scripts/token-link.mjs` | The Cloudflare token's permissions, and the dashboard link that pre-fills them. README 1.1 lists the same names. |
| `infra/` | OpenTofu (Cloudflare provider v5). |
| `config/settings.json` | Non-secret settings: plan, connector and semantic switches. |
| `.github/workflows/` | `ci`, `deploy` (merging to main deploys), `backup`, `usage`, `bump-upstream` (the original repo only) and `sync-upstream` (forks only: a weekly PR from the parent's `main`). |
| `docs/superpowers/specs`, `docs/superpowers/plans` | Design specs and implementation plans, named `YYYY-MM-DD-slug(-design).md`. |
| `docs/solutions/` | Learnings from past bugs and features (the compound loop). Read the relevant ones before you investigate or design. |
| `docs/lanes/` | How staged work runs: lanes, stages, gates, reviews. |
| `REVIEW.md` | The review checklist: defect classes found more than once, and known false positives. |
| `.claude/` | Lane workflows, subagents and skills (see below). |

## Commands

- `scripts/check.sh` is the gate every lane uses. It runs the scripts' unit tests, the connector tests, typecheck and tools-manifest check (when `connector/vendor/` exists), and `tofu fmt`. It names each check it skipped and why. Add `--upstream` when `patches/` changed.
- `npm test` runs the scripts' unit tests only (fast, needs nothing built).
- `scripts/doctor.sh` checks the account, domain, GitHub repo and `.env.local` without changing anything. Run it when setup or a deploy fails. `scripts/setup.sh` is the guided setup, safe to re-run.
- Connector checks need the vendored upstream API: `scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream`. The build needs mise's toolchain (Java, Clojure, pnpm) and takes a while; CI runs it on every PR.
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
