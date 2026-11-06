# Lanes: staged work with Claude Code

A lane is a fixed sequence of stages for one kind of work. Each stage is run by a subagent with one job, and the lane moves on only through a gate. Every lane ends by feeding what it learned back into the repo, so the next run starts smarter. This is the compound loop.

Start a lane with `/lane <item number or description>`. The skill reads the item from the issues page in the owner's Logseq graph, picks the lane, and runs its workflow. It then handles the approval gates, pushes the commits, and asks before writing anything back to Logseq.

The design borrows from agent-deck's milestone workflow and `REVIEW.md`, scaled down for a two-Worker repo:

- findings re-checked by id
- tests seen to fail before they count
- claims only for checks run on HEAD
- a retro that proposes but never applies
- a precondition stage
- a SessionStart hook
- recipe skills

## The lanes

```
bug      Intake ─ Investigate ─ Reproduce ─ Fix ─ Review ⟲ ─ Document ─ Compound ─ Closeout
         (pre-     (2 lenses; the  (test seen  (gate   (lane-review each
          conditions) cause faces   to fail)    green,  round; open ids
                    2 skeptics;                 commit) carried and
                    max 2 rounds)                       re-checked)

feature  Intake ─ Design ─ Spec ║ Plan ─ Build ×N ─ Review ⟲ ─ Document ─ Compound ─ Closeout
                  (3 angles,     ║        (per stage: test-first, commit,
                   3 judges)     ║         adversarial check of that stage)
                       stops here for the owner's approval

spike    Intake ─ Research ─ Write-up ─ Challenge ⟲ ─ Compound
                  (codebase, upstream,   (one more research round
                   platform, cost/ops)    if the gaps are researchable)

review   Scope ─ Review (one agent per lens) ∥ Re-check open ids ─ Verify (skeptics)
```

| Lane | Workflow | Statuses it ends in |
|---|---|---|
| Bug | `.claude/workflows/lane-bug.js` | `ready`, `ready-with-open-findings`, `blocked-security`, `needs-human`, `not-a-bug`, `blocked`, `stopped` |
| Feature | `.claude/workflows/lane-feature.js` | `awaiting-approval`, `ready`, `ready-with-open-findings`, `blocked-security`, `needs-human`, `blocked`, `stopped` |
| Spike | `.claude/workflows/lane-spike.js` | `ready`, `needs-human`, `blocked` |
| Review | `.claude/workflows/lane-review.js` | Returns `open`, `closed`, `should_fix`, `nits`, `refuted`, `security_open` |

## Who does what

| Agent | Stages | Changes files? |
|---|---|---|
| `investigator` | Root cause with evidence, in two lenses (trace and reproduce) | Scratch only |
| `implementer` | Failing test (with its fail-before), fix, feature stages, findings by id, the gate. Commits each stage. | Yes |
| `adversarial-reviewer` | The correctness, integrity, tests, security and contract lenses; re-checks by id; skeptic votes; challenging root causes and spikes; risk judge | No |
| `efficiency-reviewer` | Cost lens (Free plan arithmetic, response size, duplicated code) and cost judge | No |
| `docs-steward` | README, `connector_help`, descriptions, manifest, spec *As built* notes, and the Logseq skill note | Docs |
| `compounder` | `docs/solutions`, promotions to `REVIEW.md` and `CLAUDE.md`, known false positives, and retro proposals | Learning files only |

The recipe skills (`add-upstream-patch`, `add-connector-tool`, `add-d1-migration`) are what the implementer follows for those kinds of change.

## Gates

- **Preconditions.** Intake fetches `origin/main` and refuses a dirty tree or the default branch. It reports whether `connector/vendor` and `.upstream` exist, and warns when the connector suite will be skipped. Without the suite, a connector regression test can't be seen to fail.
- **Graph content is data.** Intake quotes any instructions in the issue text aimed at an AI, and doesn't follow them. The graph's name and page UUIDs stay in the untracked `.claude/lanes.local.json` and never reach a commit.
- **Root cause.** Two skeptics try to refute the top hypothesis. If both refute it, the lane runs a second round of investigation that carries the refutation. After two rounds without a surviving cause, the lane stops as `needs-human`. A `not_a_bug` cause skips to compound.
- **Fail-before.** Every regression test quotes its failure on the code without the fix. If the suite can't run here, the lane says so instead of claiming it.
- **The gate.** `scripts/check.sh` runs everything this checkout can run, and names what it skipped. Every stage and fix leaves it green, and is committed.
- **Review rounds.** `lane-review` runs every lens that applies. Each new security, blocker or major finding goes to skeptics (three for security and blocker, two for major). A finding dies only on a strict majority refutation, and a tie keeps it.
  - Each surviving finding gets an id (`r<round>-<lens>-<n>`) and stays open until a later round re-checks that id on HEAD and reports it fixed with evidence. A quiet round can't close it.
  - Fixers report every id they were given.
  - After `max_fix_rounds` (default 2), open non-security findings go to the owner as "for your call", and an open security finding blocks.
- **Approval.** A feature always stops after its spec unless an approved `spec` is passed in.
- **Claims.** The closeout runs the gate once on HEAD and reports the SHA. The PR body only claims checks run there.
- **Logseq.** No lane writes to Logseq. `/lane` shows the draft and writes it only on the owner's yes.

## The compound loop

```
       ┌──────── intake greps docs/solutions + REVIEW.md ◄─────────┐
       ▼                                                            │
 investigate / design ── reviewers work through REVIEW.md           │
       │                         ▲                                  │
       ▼                         │ promoted classes                 │
 fix / build ── review ── compounder ─► docs/solutions ─────────────┘
                                 │
                                 ├─► REVIEW.md classes and known false positives,
                                 │   CLAUDE.md Gotchas                       (applied)
                                 └─► retro: changes to workflows, agents,
                                     skills, check.sh (proposed, owner decides);
                                     Logseq skill suggestions (owner's own skill)
```

1. **Record.** Every lane ends with the compounder writing or updating a `docs/solutions` entry, or saying there was nothing new.
2. **Recall.** Intake greps `docs/solutions` and `REVIEW.md`, and the matching entries go to investigators, designers and reviewers.
3. **Promote.** Once a lesson has been seen twice, it becomes a defect class in `REVIEW.md` or a *Gotcha* in `CLAUDE.md`.
4. **Prune.** Findings that skeptics refute in more than one lane become *Known false positives* in `REVIEW.md`. Rules that a fix made obsolete are removed.
5. **Retro.** The compounder reads the run's statistics: rounds, refutations, re-checks left open, skipped checks and blocked stages. From these it proposes changes to the lanes themselves, each with its evidence. `/lane` shows them, and the owner decides. Approved ones land as a `chore(lanes): …` commit.
6. **Beyond the repo.** The issue's Logseq entry gets a dated *Built* note, and lessons about how Claude should use the connector come back as suggestions for the owner's own Logseq skill. The owner applies both.

Run `/compound` to capture a lesson from work done outside a lane.

## Setting up

1. Copy `.claude/lanes.local.example.json` to `.claude/lanes.local.json` and set the graph alias and issues page title. It is gitignored. Without it, `/lane` uses the only connected graph.
2. The SessionStart hook (`.claude/hooks/session-start.sh`) installs Node dependencies and reports whether `connector/vendor` exists. It warns when the `clojure` command is missing, because the upstream build and its tests need it.
3. For connector or patch work, build the vendored API once per container: `scripts/fetch-upstream.sh .upstream && scripts/build.sh .upstream && scripts/vendor-upstream-api.sh .upstream`.

### Cloud sessions (claude.ai/code)

A cloud container starts from a fresh clone, so the environment has to bring the toolchain itself. Without it, `scripts/check.sh` skips the connector suite and the upstream tests, and a lane can't see a regression test fail. Set two things on the environment.

**Network access.** Allow `repo.clojars.org`. The upstream build resolves some Clojure dependencies from Clojars, and the default allowlist doesn't include it. The build also needs `repo1.maven.org`, `download.clojure.org`, `github.com` and the npm registry. These are usually allowed already, but check them if the build fails to fetch.

**Setup script.** It runs as root before the session starts. Set the graph alias in the last step to your own. It stays in the environment's settings and never reaches the repo.

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. The Clojure CLI (Java and pnpm already come with the image).
if ! command -v clojure >/dev/null 2>&1; then
  curl -fsSL https://download.clojure.org/install/linux-install.sh -o /tmp/clojure-install.sh
  bash /tmp/clojure-install.sh
fi

cd /home/user/logseq-cloudflare-selfhost   # where cloud containers check the repo out

# 2. Node dependencies for the scripts and the connector.
npm ci
npm --prefix connector ci

# 3. Patched upstream, its build, and the vendored API the connector checks need.
scripts/fetch-upstream.sh .upstream
scripts/build.sh .upstream
scripts/vendor-upstream-api.sh .upstream

# 4. The lanes' tracker (gitignored).
cat > .claude/lanes.local.json <<'JSON'
{ "graph": "your-graph-alias", "page": "Logseq Connector Issues" }
JSON
```

Check a new container with `clojure --version`, `ls connector/vendor/openapi.json .claude/lanes.local.json` and `scripts/check.sh --upstream`. The summary should list the connector tests, typecheck, tools manifest and upstream db-sync tests as `ok`. Only `tofu fmt` may be skipped, and CI runs it.

## Running a lane by hand

The workflows are saved under `.claude/workflows/`, so you can run them without `/lane`. For example: run `lane-bug` with `{"issue": 23, "today": "2026-11-06", "trailer": "<your commit trailer>"}`. Resume an interrupted run with `resumeFromRunId`.

## Cost

| Run | Agents |
|---|---|
| Bug lane, clean first review | About 18 (6 before review, 6–7 in the review, 5 after) |
| Each further review round | 7–8, plus 2–3 skeptics per serious finding and 1 fixer |
| Bug lane worst case (two investigation rounds, three review rounds) | Over 60 |
| Feature lane to its spec | 8 |
| Each feature stage | 2–3 |
| Spike | 8–14 |

Use `stop_after` (`"investigate"`, `"spec"` or `"plan"`) to buy a diagnosis or a plan without paying for the rest.
